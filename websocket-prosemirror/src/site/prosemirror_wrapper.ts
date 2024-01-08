import { keydownHandler } from "prosemirror-keymap";
import { EditorState, Transaction } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { Message, WelcomeMessage } from "../common/messages";
import { BlockText } from "./block_text";

import { pcBaseKeymap } from "prosemirror-commands";

import { ListSavedState, Position } from "list-positions";
import { Fragment, Node, Slice } from "prosemirror-model";
import { ReplaceStep } from "prosemirror-transform";
import "prosemirror-view/style/prosemirror.css";
import { BlockMarker, isBlock, schema } from "./schema";

export class ProsemirrorWrapper {
  readonly view: EditorView;
  readonly blockText: BlockText<BlockMarker>;

  constructor(readonly ws: WebSocket, welcome: WelcomeMessage) {
    this.blockText = new BlockText(isBlock);

    // Load initial state into blockText.
    this.blockText.order.load(welcome.order);
    this.blockText.loadList(
      welcome.list as ListSavedState<string | BlockMarker>
    );
    // welcome.marks is not a saved state; add directly.
    for (const mark of welcome.marks) this.blockText.formatting.addMark(mark);

    // Setup Prosemirrow with initial state from blockText.
    this.view = new EditorView(document.querySelector("#editor"), {
      state: EditorState.create({ schema, doc: this.currentDoc() }),
      handleKeyDown: keydownHandler(pcBaseKeymap),
      // Sync ProseMirror changes to our local state and the server.
      dispatchTransaction: this.onLocalTr.bind(this),
    });

    // Sync server changes to our local state and ProseMirror.
    this.ws.addEventListener("message", (e) => {
      const tr = this.view.state.tr;
      tr.setMeta("ProsemirrorWrapper", true);
      const msg = JSON.parse(e.data) as Message;
      switch (msg.type) {
        case "set": {
          if (msg.meta) {
            this.blockText.order.receive([msg.meta]);
          }
          // Sets are always nontrivial.
          // Because the server enforces causal ordering, bunched values
          // are always still contiguous and have a single format.
          const pmPos = this.pmPos(tr.doc, msg.startPos);
          this.blockText.set(msg.startPos, ...msg.chars);
          const format = this.blockText.formatting.getFormat(msg.startPos);
          // TODO: use format. If grouped transactionally, wait until
          // all insertWithFormat marks have been applied?
          tr.insertText(msg.chars, pmPos);
          break;
        }
        case "setMarker": {
          if (msg.meta) {
            this.blockText.order.receive([msg.meta]);
          }
          // Sets are always nontrivial.
          const pmPos = this.pmPos(tr.doc, msg.pos);
          const marker = msg.marker as BlockMarker;
          this.blockText.set(msg.pos, marker);
          // In tests, tr.split did nothing, while tr.insert made 2 paragraph
          // breaks. Instead, we mirror the tr step seen in the other direction:
          // a ReplaceStep with open ends.
          tr.replace(
            pmPos,
            undefined,
            new Slice(
              Fragment.fromArray([
                // TODO: is it necessary to match previous node's type here?
                schema.node("paragraph"),
                schema.node(marker.type),
              ]),
              1,
              1
            )
          );
          break;
        }
        case "delete": {
          if (this.blockText.list.has(msg.pos)) {
            const value = this.blockText.list.get(msg.pos)!;
            if (typeof value !== "string" && isBlock(value)) {
              // TODO: block marker case. Need to merge block w/ previous.
              console.error("Not implemented: delete block marker.");
            } else {
              const pmPos = this.pmPos(tr.doc, msg.pos);
              this.blockText.delete(msg.pos);
              tr.delete(pmPos, pmPos + 1);
            }
          }
          break;
        }
        // TODO: setMarker, mark.
        // TODO: separate message type for block deletion?
        default:
          throw new Error("Unknown message type: " + msg.type);
      }
      if (tr.steps.length !== 0) {
        this.view.dispatch(tr);
      }
    });
  }

  private currentDoc(): Node {
    const blocks = this.blockText.blocks();
    const nodes = blocks.map((block) => {
      switch (block.marker.type) {
        case "paragraph":
          const content: Node[] = [];
          for (const piece of block.content) {
            if (typeof piece === "string") {
              if (piece.length !== 0) content.push(schema.text(piece));
            } else {
              throw new Error("Unrecognized embed: " + JSON.stringify(piece));
            }
          }
          return schema.node("paragraph", null, content);
        default:
          throw new Error(
            "Unrecognized block marker: " + JSON.stringify(block.marker)
          );
      }
    });
    return schema.node("doc", null, nodes);
  }

  private onLocalTr(tr: Transaction) {
    if (tr.getMeta("ProsemirrorWrapper")) {
      // Our own change; pass through.
      this.view.updateState(this.view.state.apply(tr));
      return;
    }

    // Apply to blockText, recording messages to send to the server.
    const messages: Message[] = [];
    for (let s = 0; s < tr.steps.length; s++) {
      const step = tr.steps[s];
      if (step instanceof ReplaceStep) {
        const fromIndex = this.textIndex(tr.docs[s], step.from);
        // Deletion
        if (step.from < step.to) {
          const toDelete = this.blockText.list.positions(
            fromIndex,
            this.textIndex(tr.docs[s], step.to)
          );
          for (const pos of toDelete) {
            messages.push({ type: "delete", pos });
            this.blockText.delete(pos);
          }
        }
        // Insertion
        const content = step.slice.content;
        if (content.childCount !== 0) {
          if (step.slice.openStart === 0 && step.slice.openEnd === 0) {
            // Insert children directly.
            this.insertInline(fromIndex, content, messages);
          } else if (step.slice.openStart === 1 && step.slice.openEnd === 1) {
            // Children are series of block nodes.
            // First's content is added to existing block; others create new
            // blocks, with last block getting the rest of the existing block's
            // content.
            let insIndex = fromIndex;
            for (let b = 0; b < content.childCount; b++) {
              const blockChild = content.child(b);
              if (blockChild.type.name !== "paragraph") {
                console.error(
                  "Warning: non-paragraph child in open slice (?)",
                  blockChild
                );
              }
              if (b !== 0) {
                // Insert new block marker before the block's content.
                const marker: BlockMarker = { type: blockChild.type.name };
                const [pos, createdBunch] = this.blockText.insertAt(
                  insIndex,
                  marker
                );
                messages.push({
                  type: "setMarker",
                  pos,
                  marker,
                  meta: createdBunch ?? undefined,
                });
                insIndex++;
              }
              insIndex = this.insertInline(
                insIndex,
                blockChild.content,
                messages
              );
            }
          } else console.error("Unsupported open start/end", step.slice);
        }
      } else {
        console.error("Unsupported step", step);
      }
    }

    // Tell the server.
    // TODO: group as tr.
    for (const message of messages) {
      this.send(message);
    }

    // Let ProseMirror apply the tr normally.
    this.view.updateState(this.view.state.apply(tr));
  }

  /**
   * @returns New insIndex
   */
  private insertInline(
    insIndex: number,
    content: Fragment,
    messages: Message[]
  ): number {
    for (let c = 0; c < content.childCount; c++) {
      const child = content.child(c);
      switch (child.type.name) {
        case "text":
          // Simple text insertion.
          const [startPos, createdBunch] = this.blockText.insertAt(
            insIndex,
            ...child.text!
          );
          insIndex += child.nodeSize;
          messages.push({
            type: "set",
            startPos,
            chars: child.text!,
            meta: createdBunch ?? undefined,
          });
          break;
        default:
          console.error("Unsupported child", child);
      }
    }
    return insIndex;
  }

  /**
   * Returns the index in blockText.list corresponding to the given ProseMirror
   * position.
   *
   * If pmPos points to (the start of) a block, the index points to that block's
   * marker.
   *
   * doc and this.blockText must be in sync.
   */
  private textIndex(doc: Node, pmPos: number): number {
    const resolved = doc.resolve(pmPos);
    switch (resolved.parent.type.name) {
      case "doc": {
        // Block resolved.index(0). Return index of its block marker.
        const markerPos = this.blockText.blockMarkers.positionAt(
          resolved.index(0)
        );
        return this.blockText.list.indexOfPosition(markerPos);
      }
      case "paragraph": {
        // Block resolved.index(0), inline node resolved.index(1), char resolved.textOffset.
        // For insertions at the end of a text node, index(1) is one greater
        // (possibly out-of-bounds) and textOffset is 0.
        const pmBlock = resolved.parent;
        const blockPos = this.blockText.blockMarkers.positionAt(
          resolved.index(0)
        );
        // Total size of previous inline nodes.
        let prevInline = 0;
        for (let c = 0; c < resolved.index(1); c++) {
          prevInline += pmBlock.content.child(c).nodeSize;
        }
        // Add: Block marker index, 1 to move inside block, prevInline,
        // then offset into the (possibly out-of-bounds) actual inline node.
        return (
          this.blockText.list.indexOfPosition(blockPos) +
          1 +
          prevInline +
          resolved.textOffset
        );
      }
      default:
        throw new Error(
          "Unrecognized parent type: " + JSON.stringify(resolved.parent)
        );
    }
  }

  /**
   * Returns the ProseMirror position corresponding to the given
   * Position.
   *
   * If pos is not present, returns the ProseMirror position corresponding to
   * where the pos would be (ignoring whether it's a block), i.e., the
   * ProseMirror position to insert at.
   *
   * If pos's present value is a block marker, the ProseMirror position points
   * to the start of that block.
   *
   * doc and this.blockText must be in sync.
   */
  private pmPos(doc: Node, pos: Position): number {
    const blockIndex = this.blockText.blockMarkers.indexOfPosition(pos, "left");
    const blockPos = this.blockText.blockMarkers.positionAt(blockIndex);
    // 0-indexed from the block marker itself. So value indices within
    // the block are 1 less.
    const indexInBlock =
      this.blockText.list.indexOfPosition(pos, "right") -
      this.blockText.list.indexOfPosition(blockPos);

    // Find the total size of previous blocks.
    let blockStart = 0;
    for (let b = 0; b < blockIndex; b++) {
      blockStart += doc.child(b).nodeSize;
    }

    return blockStart + indexInBlock;
  }

  private send(msg: Message) {
    if (this.ws.readyState == WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}
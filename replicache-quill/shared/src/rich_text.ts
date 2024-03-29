import type {TimestampMark} from 'list-formatting';
import type {BunchMeta, Position} from 'list-positions';
import type {ReadTransaction} from 'replicache';

export type Bunch = {
  meta: BunchMeta;
  values: {[innerIndex: number]: string};
};

export type CreateBunch = BunchMeta;

export type SetValues = {
  startPos: Position;
  values: string[];
};

export type DeleteValues = {
  startPos: Position;
  count: number;
};

export async function allBunches(tx: ReadTransaction) {
  return await tx.scan<Bunch>({prefix: 'bunch/'}).values().toArray();
}

export function idOfMark(mark: TimestampMark): string {
  return `${mark.timestamp + ',' + mark.creatorID}`;
}

export type AddMarks = {
  marks: TimestampMark[];
};

export async function allMarks(tx: ReadTransaction) {
  return await tx.scan<TimestampMark>({prefix: 'mark/'}).values().toArray();
}

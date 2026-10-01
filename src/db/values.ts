export const id = (value: string | bigint): string => String(value);

export const optId = (value: string | bigint | null): string | null =>
  value === null ? null : String(value);

export const num = (value: number | bigint | string): number => Number(value);

export const optNum = (value: number | bigint | string | null): number | null =>
  value === null ? null : Number(value);

export const flag = (value: number | bigint): boolean => Number(value) !== 0;

export const toFlag = (value: boolean): number => (value ? 1 : 0);

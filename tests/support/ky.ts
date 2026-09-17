import ky, { type KyInstance } from "ky";

/** Layer test verbs onto a real ky client so its callable contract stays intact. */
export function stubKy(verbs: Partial<KyInstance>): KyInstance {
  return Object.assign(ky.create(), verbs);
}

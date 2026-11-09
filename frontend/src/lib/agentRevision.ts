/** A conflict requires a fresh project read, not merely another attempt at writing. */
export class RevisionGuard {
  private needsRead = false;
  constructor(private revision: number | undefined) {}
  before(revision: number | undefined, read: boolean): void {
    if (revision !== this.revision) this.needsRead = true;
    if (!read && this.needsRead) throw new Error('工程版本已变化；本操作未执行。先读取最新目标牌组/版式，再修改。');
  }
  after(revision: number | undefined, projectRead: boolean): void {
    this.revision = revision;
    if (projectRead) this.needsRead = false;
  }
}

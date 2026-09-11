// 撤销 / 重做历史栈：用于角度调整等参数化操作的时光机
// 设计要点：
// 1. 只存「状态快照 + 标签」，不存图像数据，因此内存占用极小
// 2. 合并策略：连续拖动同一个滑块时，把多次变更合并成一个提交（避免 1px 一步产生上百条历史）

export class History {
  /**
   * @param {object} opts
   * @param {number} opts.limit 最大历史条数（默认 60）
   * @param {number} opts.mergeMs 同标签合并窗口（默认 450ms）
   * @param {(s:any)=>any} opts.clone 状态深拷贝函数
   */
  constructor({ limit = 60, mergeMs = 450, clone = (s) => JSON.parse(JSON.stringify(s)) } = {}) {
    this.limit = limit;
    this.mergeMs = mergeMs;
    this.clone = clone;
    this.stack = [];
    this.index = -1;
    this.lastLabel = null;
    this.lastTime = 0;
    this.listeners = [];
  }

  on(fn) {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((f) => f !== fn);
    };
  }

  emit() {
    const st = this.status();
    for (const fn of this.listeners) fn(st);
  }

  status() {
    return {
      canUndo: this.index > 0,
      canRedo: this.index >= 0 && this.index < this.stack.length - 1,
      size: this.stack.length,
      index: this.index,
      label: this.index >= 0 ? this.stack[this.index].label : '',
    };
  }

  /** 初始化：把初始状态压入栈底 */
  reset(state, label = '初始状态') {
    this.stack = [{ state: this.clone(state), label, time: Date.now() }];
    this.index = 0;
    this.lastLabel = null;
    this.lastTime = 0;
    this.emit();
  }

  /**
   * 提交一次变更。
   * @param {any} state 变更后的完整状态
   * @param {string} label 变更标签（如 '水平旋转'）
   * @param {boolean} merge 是否允许与上一次同标签变更合并
   */
  commit(state, label, merge = false) {
    const now = Date.now();
    const snapshot = { state: this.clone(state), label, time: now };

    // 合并窗口：同标签 + 时间接近 + 处于栈顶 → 覆盖栈顶而不是新增
    const canMerge =
      merge &&
      this.index >= 0 &&
      this.stack.length > 0 &&
      this.index === this.stack.length - 1 &&
      label === this.stack[this.index].label &&
      now - this.lastTime < this.mergeMs;

    if (canMerge) {
      this.stack[this.index] = snapshot;
      this.lastTime = now;
      this.emit();
      return;
    }

    // 丢弃当前指针之后的「未来」
    if (this.index < this.stack.length - 1) this.stack.length = this.index + 1;
    this.stack.push(snapshot);
    if (this.stack.length > this.limit) this.stack.shift();
    this.index = this.stack.length - 1;
    this.lastLabel = label;
    this.lastTime = now;
    this.emit();
  }

  /** 结束一次连续操作（松手时调用），打断合并窗口 */
  seal() {
    this.lastTime = 0;
    this.lastLabel = null;
  }

  undo() {
    if (this.index <= 0) return null;
    this.index -= 1;
    this.seal();
    this.emit();
    return this.clone(this.stack[this.index].state);
  }

  redo() {
    if (this.index >= this.stack.length - 1) return null;
    this.index += 1;
    this.seal();
    this.emit();
    return this.clone(this.stack[this.index].state);
  }

  current() {
    if (this.index < 0) return null;
    return this.clone(this.stack[this.index].state);
  }

  clear() {
    this.stack = [];
    this.index = -1;
    this.seal();
    this.emit();
  }

  /** 返回精简的历史列表（用于下拉菜单展示） */
  list() {
    return this.stack.map((s, i) => ({ label: s.label, time: s.time, active: i === this.index }));
  }
}

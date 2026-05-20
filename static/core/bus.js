// Tiny pub/sub event bus shared by all modules and widgets.
const _L = {};
export const bus = {
  on(e, fn)  { (_L[e] ??= []).push(fn); return () => this.off(e, fn); },
  off(e, fn) { _L[e] = (_L[e] || []).filter(f => f !== fn); },
  emit(e, d) { (_L[e] || []).slice().forEach(fn => fn(d)); },
};

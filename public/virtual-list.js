(function exposeVirtualList(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.VirtualList = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createVirtualList() {
  function calculateRange({ itemCount, scrollTop, viewportHeight, rowHeight, overscan }) {
    if (itemCount <= 0 || rowHeight <= 0) return { start: 0, end: 0 };

    const firstVisible = Math.floor(Math.max(0, scrollTop) / rowHeight);
    const visibleCount = Math.max(1, Math.ceil(Math.max(0, viewportHeight) / rowHeight));
    return {
      start: Math.max(0, firstVisible - overscan),
      end: Math.min(itemCount, firstVisible + visibleCount + overscan)
    };
  }

  return { calculateRange };
});

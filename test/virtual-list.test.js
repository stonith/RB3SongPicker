const { calculateRange } = require('../public/virtual-list');

describe('virtual list range calculation', () => {
  it('renders the initial viewport with overscan', () => {
    expect(calculateRange({
      itemCount: 2500,
      scrollTop: 0,
      viewportHeight: 660,
      rowHeight: 66,
      overscan: 12
    })).toEqual({ start: 0, end: 22 });
  });

  it('renders a bounded window in the middle of a large list', () => {
    expect(calculateRange({
      itemCount: 2500,
      scrollTop: 6600,
      viewportHeight: 660,
      rowHeight: 66,
      overscan: 12
    })).toEqual({ start: 88, end: 122 });
  });

  it('clamps the range at the end of the list', () => {
    expect(calculateRange({
      itemCount: 2500,
      scrollTop: 164340,
      viewportHeight: 660,
      rowHeight: 66,
      overscan: 12
    })).toEqual({ start: 2478, end: 2500 });
  });

  it('handles an empty list', () => {
    expect(calculateRange({
      itemCount: 0,
      scrollTop: 0,
      viewportHeight: 660,
      rowHeight: 66,
      overscan: 12
    })).toEqual({ start: 0, end: 0 });
  });
});

// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

function Hello() {
  return <p>hello react</p>;
}

describe('react smoke render', () => {
  it('renders a trivial component', () => {
    render(<Hello />);
    expect(screen.getByText('hello react')).toBeTruthy();
  });
});

import { describe, expect, it } from 'vitest';
import { normCdf, normInv, normPdf } from '../../src/indicators';

// Reference values from Python: 0.5 * math.erfc(-x / sqrt(2)) and statistics.NormalDist().inv_cdf (AS241).
const CDF_TABLE: [number, number][] = [
  [-10, 7.619853024160595e-24],
  [-8, 6.220960574271819e-16],
  [-6, 9.865876450377016e-10],
  [-5, 2.8665157187919455e-7],
  [-4, 3.1671241833119965e-5],
  [-3, 0.0013498980316300959],
  [-2, 0.022750131948179216],
  [-1.5, 0.06680720126885809],
  [-1, 0.15865525393145707],
  [-0.5, 0.30853753872598694],
  [-0.1, 0.460172162722971],
  [0, 0.5],
  [0.1, 0.539827837277029],
  [0.5, 0.691462461274013],
  [1, 0.8413447460685428],
  [1.5, 0.9331927987311419],
  [2, 0.9772498680518209],
  [3, 0.9986501019683699],
  [4, 0.9999683287581669],
  [5, 0.9999997133484282],
  [8, 0.9999999999999993],
];

const PDF_TABLE: [number, number][] = [
  [-3, 0.0044318484119380075],
  [-1, 0.24197072451914337],
  [0, 0.3989422804014327],
  [0.5, 0.3520653267642995],
  [2, 0.05399096651318806],
];

const INV_TABLE: [number, number][] = [
  [1e-10, -6.361340902404056],
  [1e-6, -4.753424308822899],
  [0.001, -3.090232306167813],
  [0.01, -2.3263478740408408],
  [0.025, -1.9599639845400538],
  [0.1, -1.2815515655446008],
  [0.25, -0.6744897501960817],
  [0.5, 0],
  [0.75, 0.6744897501960817],
  [0.9, 1.2815515655446008],
  [0.975, 1.9599639845400536],
  [0.99, 2.3263478740408408],
  [0.999, 3.090232306167813],
  [0.999999, 4.753424308817089],
];

describe('normCdf', () => {
  it.each(CDF_TABLE)('matches the erfc reference at x = %f', (x, expected) => {
    // abs error < 1e-9 (spec) and in fact ~1e-15; relative accuracy also holds in the tails.
    expect(Math.abs(normCdf(x) - expected)).toBeLessThan(1e-9);
    expect(Math.abs(normCdf(x) - expected)).toBeLessThanOrEqual(1e-14 + 1e-12 * expected);
  });

  it('is symmetric: Phi(x) + Phi(-x) = 1', () => {
    for (let x = -8; x <= 8; x += 0.37) {
      expect(normCdf(x) + normCdf(-x)).toBeCloseTo(1, 14);
    }
  });

  it('is monotone increasing and bounded', () => {
    let prev = -1;
    for (let x = -40; x <= 40; x += 0.25) {
      const v = normCdf(x);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('handles extremes and NaN', () => {
    expect(normCdf(-50)).toBe(0);
    expect(normCdf(50)).toBe(1);
    expect(normCdf(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(normCdf(Number.POSITIVE_INFINITY)).toBe(1);
    expect(normCdf(Number.NaN)).toBeNaN();
  });

  it('has derivative normPdf (central difference)', () => {
    const h = 1e-5;
    for (const x of [-3, -1.2, -0.3, 0, 0.7, 2.1]) {
      expect((normCdf(x + h) - normCdf(x - h)) / (2 * h)).toBeCloseTo(normPdf(x), 8);
    }
  });
});

describe('normPdf', () => {
  it.each(PDF_TABLE)('matches the reference at x = %f', (x, expected) => {
    expect(normPdf(x)).toBeCloseTo(expected, 14);
  });

  it('is even and integrates to ~1 (trapezoid)', () => {
    expect(normPdf(1.3)).toBe(normPdf(-1.3));
    let sum = 0;
    const h = 0.001;
    for (let x = -10; x <= 10; x += h) sum += normPdf(x) * h;
    expect(sum).toBeCloseTo(1, 6);
  });
});

describe('normInv', () => {
  it.each(INV_TABLE)('matches AS241 reference at p = %f', (p, expected) => {
    expect(Math.abs(normInv(p) - expected)).toBeLessThan(1e-9);
    expect(Math.abs(normInv(p) - expected)).toBeLessThan(1e-9 * Math.max(1, Math.abs(expected)));
  });

  it('round trips with normCdf', () => {
    for (const p of [1e-12, 1e-8, 1e-4, 0.01, 0.2, 0.5, 0.8, 0.99, 1 - 1e-8]) {
      expect(normCdf(normInv(p))).toBeCloseTo(p, 12);
    }
    for (let x = -6; x <= 6; x += 0.25) {
      expect(normInv(normCdf(x))).toBeCloseTo(x, 7);
    }
  });

  it('is antisymmetric', () => {
    for (const p of [0.001, 0.05, 0.3, 0.45]) {
      expect(normInv(1 - p)).toBeCloseTo(-normInv(p), 12);
    }
  });

  it('handles the boundaries', () => {
    expect(normInv(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(normInv(1)).toBe(Number.POSITIVE_INFINITY);
    expect(normInv(-0.1)).toBeNaN();
    expect(normInv(1.1)).toBeNaN();
    expect(normInv(Number.NaN)).toBeNaN();
  });
});

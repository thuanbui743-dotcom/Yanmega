// Draft win-rate predictor: P(team A beats team B) from full sets. Trained by scripts/train-oracle.ts.
import * as fs from 'fs';
import * as path from 'path';
import type { Card } from '../types';
import { matchupVector, FEATURE_NAMES } from './features';

export interface OracleModel { names: string[]; w: number[]; scale: number[]; trainedOn: number; holdoutAcc: number; holdoutLogLoss: number }

const MODEL_PATH = path.join(__dirname, '..', '..', 'data', 'oracle.json');
let model: OracleModel | null = null;

export function loadOracle(): OracleModel | null {
  if (model) return model;
  if (!fs.existsSync(MODEL_PATH)) return null;
  const m = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8')) as OracleModel;
  if (m.names.join() !== FEATURE_NAMES.join()) return null; // features changed since training
  return (model = m);
}

export function scoreVector(x: number[], m: OracleModel): number {
  let z = 0;
  for (let i = 0; i < x.length; i++) z += m.w[i] * (x[i] / m.scale[i]);
  return z;
}

/** Probability that team A beats team B (0.5 if no model is trained yet). Symmetric: winProb(A,B) = 1 - winProb(B,A). */
export function winProb(A: Card[], B: Card[]): number {
  const m = loadOracle();
  if (!m) return 0.5;
  return 1 / (1 + Math.exp(-scoreVector(matchupVector(A, B), m)));
}

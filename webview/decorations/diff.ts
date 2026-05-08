import { Compartment } from '@codemirror/state';
import { unifiedMergeView } from '@codemirror/merge';

const diffCompartment = new Compartment();

export const diffInitial = diffCompartment.of([]);

export function buildDiffExtension(original: string) {
  return diffCompartment.reconfigure(unifiedMergeView({ original, mergeControls: false }));
}

export function clearDiffExtension() {
  return diffCompartment.reconfigure([]);
}

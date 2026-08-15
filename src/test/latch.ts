export function createBarrier(parties: number) {
  let arrived = 0;
  const { promise, resolve } = Promise.withResolvers<void>();   // Node 22
  return { async arrive() { if (++arrived >= parties) resolve(); await promise; } };
}

export function createGate() {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { wait: () => promise, open: () => resolve() };
}
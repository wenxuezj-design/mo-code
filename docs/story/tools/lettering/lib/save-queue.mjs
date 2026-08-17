export function createSaveQueue(persistSnapshot) {
  let tail = Promise.resolve();

  return function enqueueSave(snapshot) {
    const operation = tail
      .catch(() => {})
      .then(() => persistSnapshot(snapshot));
    tail = operation;
    return operation;
  };
}

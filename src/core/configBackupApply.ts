/** Apply local settings and native config as one recoverable pre-commit step. */
export async function applyWithLocalRollback<T>(options: {
  writeLocal: () => void;
  rollbackLocal: () => void;
  applyNative: () => Promise<T>;
}): Promise<T> {
  try {
    options.writeLocal();
    return await options.applyNative();
  } catch (error) {
    try {
      options.rollbackLocal();
    } catch (rollbackError) {
      throw new Error(`native apply failed: ${String(error)}; local rollback failed: ${String(rollbackError)}`);
    }
    throw error;
  }
}

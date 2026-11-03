/** Best-effort paid-call cap for one process; restarts and scaling reset it. */
export function createDailyModelBudget({ now = Date.now, limit = 250 } = {}) {
  let utcDay;
  let used = 0;
  return async function reserveModelCall() {
    const currentDay = new Date(now()).toISOString().slice(0, 10);
    if (currentDay !== utcDay) {
      utcDay = currentDay;
      used = 0;
    }
    if (used >= limit) return false;
    used++;
    return true;
  };
}

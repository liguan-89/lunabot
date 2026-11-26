import { useCallback, useEffect, useRef, useState } from "react";

export function useBusyCounter() {
  const [busy, setBusy] = useState(false);
  const count = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const begin = useCallback(() => {
    count.current += 1;
    setBusy(true);
  }, []);

  const end = useCallback(() => {
    count.current = Math.max(0, count.current - 1);
    if (mounted.current && count.current === 0) setBusy(false);
  }, []);

  const reset = useCallback(() => {
    count.current = 0;
    if (mounted.current) setBusy(false);
  }, []);

  return { busy, begin, end, reset };
}

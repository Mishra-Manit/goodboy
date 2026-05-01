/** Minimal keyed data-fetching hook: state machine around one async thunk, with manual refetch. */

import { useCallback, useEffect, useRef, useState } from "react";

interface QueryResult<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refetch: () => void;
}

export function useQuery<T>(key: string, fn: () => Promise<T>): QueryResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const callId = useRef(0);
  const fnRef = useRef(fn);

  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  const execute = useCallback(async () => {
    const id = ++callId.current;
    setLoading(true);
    setError(null);
    try {
      const result = await fnRef.current();
      if (id === callId.current) setData(result);
    } catch (err) {
      if (id === callId.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (id === callId.current) setLoading(false);
    }
  }, [key]);

  useEffect(() => {
    execute();
  }, [execute]);

  return { data, error, loading, refetch: execute };
}

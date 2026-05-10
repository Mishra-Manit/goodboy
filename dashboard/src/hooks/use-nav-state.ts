/** Shared nav visibility context so pages can adapt layout when the nav hides. */

import { createContext, useContext } from "react";

interface NavState {
  hidden: boolean;
  setHidden: (hidden: boolean) => void;
}

export const NavStateContext = createContext<NavState>({ hidden: false, setHidden: () => {} });

export function useNavState(): NavState {
  return useContext(NavStateContext);
}

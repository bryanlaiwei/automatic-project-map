import { createContext } from "react";

export type MapActions = {
  selectFeature: (featureId: string) => void;
  selectWorkItem: (workItemId: string) => void;
  toggle: (featureId: string) => void;
};

export const MapActionsContext = createContext<MapActions>({
  selectFeature: () => undefined,
  selectWorkItem: () => undefined,
  toggle: () => undefined,
});

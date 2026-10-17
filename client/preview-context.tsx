import { createContext, useContext } from 'react';
export const PreviewContext = createContext(false);
export const usePreview = () => useContext(PreviewContext);

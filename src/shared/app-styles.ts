export const APP_STYLES_START = "/* mira-app-styles:start */";
export const APP_STYLES_END = "/* mira-app-styles:end */";

export interface AppStylesheetUpdate {
  originalURL: string;
  url: string;
  revision: number;
}

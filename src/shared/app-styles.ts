export const APP_STYLES_START = "/* orbit-app-styles:start */";
export const APP_STYLES_END = "/* orbit-app-styles:end */";

export interface AppStylesheetUpdate {
  originalURL: string;
  url: string;
  revision: number;
}

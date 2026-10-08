declare module "*.md" {
  const text: string;
  export default text;
}
declare module "*.mp3" {
  const path: string;
  export default path;
}
declare module "*.schema" {
  const text: string;
  export default text;
}
interface JSON {
  rawJSON(text: string): { readonly rawJSON: string };
}

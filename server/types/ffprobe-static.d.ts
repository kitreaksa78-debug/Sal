// ffprobe-static ships no type definitions, so declare the minimal surface we use.
declare module 'ffprobe-static' {
  const ffprobeStatic: { path: string; version?: string };
  export default ffprobeStatic;
}

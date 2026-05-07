declare module 'simplify-js' {
  export default function simplify<T extends {x: number, y: number}>(points: T[], tolerance?: number, highQuality?: boolean): T[];
}

declare module 'debug' {
  export default function debug(namespace: string): (...args: unknown[]) => void;
}

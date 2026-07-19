export function isWorkbenchBlob(value: unknown): value is Blob {
  if (typeof Blob !== "undefined" && value instanceof Blob) return true;
  if (typeof value !== "object" || value === null) return false;

  try {
    if (Object.prototype.toString.call(value) !== "[object Blob]") return false;
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (!prototype || prototype === Object.prototype) return false;

    const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
    const tag = Object.getOwnPropertyDescriptor(prototype, Symbol.toStringTag);
    const size = Object.getOwnPropertyDescriptor(prototype, "size");
    const type = Object.getOwnPropertyDescriptor(prototype, "type");
    if (
      typeof constructor !== "function"
      || constructor.name !== "Blob"
      || tag?.value !== "Blob"
      || tag.writable !== false
      || tag.enumerable !== false
      || typeof size?.get !== "function"
      || size.set !== undefined
      || typeof type?.get !== "function"
      || type.set !== undefined
    ) {
      return false;
    }

    const candidate = value as Blob;
    if (
      !Number.isSafeInteger(candidate.size)
      || candidate.size < 0
      || typeof candidate.type !== "string"
    ) {
      return false;
    }

    for (const method of ["arrayBuffer", "slice", "stream", "text"] as const) {
      if (
        Object.hasOwn(value, method)
        || typeof Object.getOwnPropertyDescriptor(prototype, method)?.value !== "function"
      ) {
        return false;
      }
    }

    const slice = Object.getOwnPropertyDescriptor(prototype, "slice")?.value as Blob["slice"];
    const probe = Reflect.apply(slice, value, [0, 0]) as unknown;
    return typeof probe === "object"
      && probe !== null
      && probe !== value
      && Object.prototype.toString.call(probe) === "[object Blob]"
      && (probe as Blob).size === 0
      && typeof (probe as Blob).type === "string"
      && typeof (probe as Blob).arrayBuffer === "function"
      && typeof (probe as Blob).slice === "function"
      && typeof (probe as Blob).stream === "function"
      && typeof (probe as Blob).text === "function";
  } catch {
    return false;
  }
}

/** Replaces some methods while keeping the rest bound to the original (which may be a class). */
export function override<T extends object>(target: T, replacements: Partial<T>): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      if (Object.hasOwn(replacements, property)) {
        return replacements[property as keyof T];
      }
      const value: unknown = Reflect.get(object, property, receiver);
      return typeof value === 'function' ? value.bind(object) : value;
    },
    has(object, property) {
      return Object.hasOwn(replacements, property) || Reflect.has(object, property);
    },
  });
}

/** What is left of a model catalog after the ids Luna Bot hid. The hidden ids stay valid elsewhere. */
export function withoutHiddenModels<Option extends { id: string }, Catalog extends { default: string; options: Option[] }>(
  models: Catalog,
  hidden: ReadonlySet<string>,
): Catalog {
  if (hidden.size === 0) return models;
  const options = models.options.filter((option) => !hidden.has(option.id));
  const defaultVisible = options.some((option) => option.id === models.default);
  return { ...models, options, ...(defaultVisible ? {} : { default: options[0]?.id ?? models.default }) } as Catalog;
}
export default {};

export const createRequire = () => {
  throw new Error("Node require is not available in the browser runtime.");
};

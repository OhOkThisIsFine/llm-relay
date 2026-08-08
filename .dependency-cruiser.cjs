module.exports = {
  options: {
    tsConfig: {
      fileName: "./tsconfig.json",
    },
    doNotFollow: {
      path: "node_modules",
    },
    includeOnly: "^((src|test|scripts)/)",
    exclude: "(^node_modules|^dist)",
  },
  forbidden: [
    {
      name: "no-circular",
      comment: "Disallow circular dependencies in project modules",
      severity: "warn",
      from: {},
      to: {
        circular: true,
      },
    },
  ],
};

export const TUTORIAL = [
  { slug: "tutorial/before", title: "Before you start", short: "Before you start", blurb: "What you need and where tapster runs." },
  { slug: "tutorial/apple", title: "Get your Apple credentials", short: "Apple credentials", blurb: "Export a Developer ID certificate and create a notarization key." },
  { slug: "tutorial/hub", title: "Create the hub", short: "Create the hub", blurb: "Run tapster init in your tap." },
  { slug: "tutorial/project", title: "Add a project", short: "Add a project", blurb: "Run tapster add in a project and merge its hub entry." },
  { slug: "tutorial/release", title: "Ship the first release", short: "First release", blurb: "Push a tag and install the signed release." },
] as const;

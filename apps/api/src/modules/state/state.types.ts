export type Phase1ProductStateInput = {
  title: string;
  businessGoal: string;
  pages: unknown[];
  rules: unknown[];
};

export type Phase1Prd = {
  sections: Array<{
    title: string;
    content: string;
  }>;
};

export type Phase1Prototype = {
  html: string;
};

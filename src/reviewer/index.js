/**
 * @file Reviewer Gate — public entry point. Everything outside this
 * directory that needs the reviewer imports from here, not from the
 * individual layer files.
 */
export { reviewAction } from './reviewer.js';
export { classifyAction } from './policy.js';
export { REVIEWER_PERSONA_PROMPT, buildReviewMessages } from './prompts.js';
export { getSystemStateSnapshot, __resetSystemStateCacheForTests } from './systemState.js';
export { appendReview, listReviewFiles, REVIEWS_DIR } from './store.js';

export { reviewAction as default } from './reviewer.js';

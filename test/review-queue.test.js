'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isOpenReview } = require('../scripts/lib/precheck/review-queue');

test('excluded_from_pool is never an open review', () => {
  assert.equal(isOpenReview({
    status: 'excluded_from_pool',
    final_year: '',
  }), false);
});

test('open status stays open even when final_year is accidentally present', () => {
  assert.equal(isOpenReview({
    status: 'review_needed',
    final_year: '1984',
  }), true);
});

test('legacy open hints keep a row open even with final_year', () => {
  assert.equal(isOpenReview({
    status: 'auto_accepted_mb',
    final_year: '1984',
    existing_notes: 'pending_review from previous CSV',
  }), true);
});

test('row without final_year is open unless excluded', () => {
  assert.equal(isOpenReview({
    status: 'auto_accepted_mb',
    final_year: '',
  }), true);
});

test('upload-ready row without open hints is not open', () => {
  assert.equal(isOpenReview({
    status: 'auto_accepted_mb',
    final_year: '1984',
  }), false);
});

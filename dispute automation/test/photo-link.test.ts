import { test } from 'node:test';
import assert from 'node:assert/strict';
import { originalPhotoUrl } from '../src/content/dom.ts';

// The real links from DoorDash order DB32CE94: the 72px thumbnail in the sheet and the full photo in its pop-up.
const ORIGINAL = 'https://media-platform.cdn4dd.com/media/cnr_photo_proof/processed/47c0dd33-39bc-4b5c-aff4-1b587887b769.jpg';
const THUMBNAIL = `https://img.cdn4dd.com/cdn-cgi/image/fit=cover,width=72,height=72,format=auto/${ORIGINAL}`;

test('a DoorDash thumbnail leads to the full-size original', () => {
  assert.equal(originalPhotoUrl(THUMBNAIL), ORIGINAL);
  assert.equal(originalPhotoUrl(ORIGINAL), ORIGINAL);
});

test('other pictures have no original link', () => {
  assert.equal(originalPhotoUrl('https://img.cdn4dd.com/cdn-cgi/image/fit=cover,width=72,height=72/https://img.cdn4dd.com/p/fit=cover,width=150/media/photosV2/menu-item.jpg'), null);
  assert.equal(originalPhotoUrl('https://media-platform.cdn4dd.com/media/profile/avatar.jpg'), null);
  assert.equal(originalPhotoUrl('https://evil.example/media/cnr_photo_proof/processed/x.jpg'), null);
  assert.equal(originalPhotoUrl('data:image/png;base64,AAAA'), null);
  assert.equal(originalPhotoUrl(''), null);
});

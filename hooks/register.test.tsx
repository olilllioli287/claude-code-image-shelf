import { test, expect } from 'claude-code/testing'

import { heicPathsIn } from './register'

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

test('no images in the box: the band is left to the engine', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="engine">engine</Text>
  })
  const ui = await $.ui.mount({ plugin: 'image-shelf', surface: 'terminal', ...BAND })
  expect(await ui.find({ key: 'open-1' })).toBeUndefined()
  expect((await ui.find({ key: 'engine', plugin: 'test' }))?.text ?? 'engine').toBe('engine')
  await ui.unmount()
})

// HEIC photos (what an iPhone takes) are not attached by Claude Code; a path to one, however
// it reached the box, is found so the shelf can convert it.
test('HEIC paths: plain, escaped, quoted, ~, any case; other text is left alone', async () => {
  const home = '/Users/me'
  const text = [
    '看這張 /Users/me/Downloads/IMG_1729.HEIC 和',
    "'/Users/me/My Photos/a b.heic'",
    '"/tmp/x y.HEIF"',
    '/Users/me/Desktop/class\\ photo.heic,',
    '~/Pictures/z.HeIc',
    'photo.heic.txt /tmp/not-heic.png heic',
  ].join(' ')
  expect(heicPathsIn(text, home)).toEqual([
    '/Users/me/Downloads/IMG_1729.HEIC',
    '/Users/me/My Photos/a b.heic',
    '/tmp/x y.HEIF',
    '/Users/me/Desktop/class photo.heic',
    '/Users/me/Pictures/z.HeIc',
  ])
})

test('no HEIC and nothing edited: the prompt goes on untouched', async ($, on) => {
  let seen: readonly string[] | undefined = ['unset']
  on('prompt.submit', ($, e) => {
    seen = e.context
    return { text: e.text }
  })
  await $.prompt.submit({ text: 'just a question about photo.heic.txt', asUser: true })
  expect(seen === undefined || seen.length === 0).toBe(true)
})

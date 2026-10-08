import { test, expect } from 'claude-code/testing'

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

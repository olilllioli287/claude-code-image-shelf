// One pasted image: the N of its [Image #N], the editable copy Preview opens, and the
// small PNG the band draws where the terminal can draw pictures.
export type Shot = {
  n: number
  // The copy in our own folder; '' until Claude Code's copy of the paste is found.
  copy: string
  thumb: string
  // The copy's mtime when it was made; a later one means Preview saved an edit.
  madeAt: number
  isEdited: boolean
  // Bumped each time the picture changes, so the thumbnail is read again.
  gen: number
  width: number
  height: number
}

declare module 'claude-code' {
  interface PluginState {
    'image-shelf': { shots: Shot[]; inBox: number[]; roomRows: number }
  }
}

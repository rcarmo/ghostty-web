// Fullscreen blit used to composite the offscreen scene texture (the
// terminal frame rendered by the background/glyph/decoration passes) onto
// the visible canvas. Reused for both the default (no-op) composite and, for
// any consumer that installs a custom shader via
// WebGLRenderer.setPostProcessShader, the post-processed composite — same
// vertex stage either way, only the fragment stage differs.
export const postProcessVertexSource = `#version 300 es
precision highp float;

layout(location = 0) in vec2 a_position;

out vec2 v_uv;

void main() {
  // The scene FBO is rendered with the same row0-at-clip-top convention as
  // every other pass in this renderer (ndc.y flipped below), which means row
  // 0 ends up written at texture v=1, not v=0 — GL's texture v axis and its
  // clip-space y axis point the same way, so flipping clip space to put row
  // 0 "on top" visually also puts it at the texture's v=1 edge. Flip v_uv.y
  // here to compensate, so sampling at the on-screen top actually reads the
  // terminal's top row instead of its bottom row.
  v_uv = vec2(a_position.x, 1.0 - a_position.y);
  vec2 ndc = a_position * 2.0 - 1.0;
  ndc.y = -ndc.y;
  gl_Position = vec4(ndc, 0.0, 1.0);
}
`;

// Default composite: sample the scene texture unmodified. Used whenever no
// custom post-process shader is installed.
export const passthroughPostProcessFragmentSource = `#version 300 es
precision highp float;

in vec2 v_uv;
uniform sampler2D u_scene;

out vec4 fragColor;

void main() {
  fragColor = texture(u_scene, v_uv);
}
`;

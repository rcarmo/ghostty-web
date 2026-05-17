export const backgroundVertexSource = `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in vec2 a_position;
layout(location = 1) in uvec4 a_atlasRect;
layout(location = 2) in ivec2 a_bearing;
layout(location = 3) in uvec4 a_flags;
layout(location = 4) in uvec4 a_fgColor;
layout(location = 5) in uvec4 a_bgColor;
layout(location = 6) in uvec4 a_decoColor;
layout(location = 7) in uint a_reserved;

uniform vec2 u_cellSize;
uniform vec2 u_gridSize;

out vec4 v_bgColor;
flat out float v_skip;

void main() {
  uint cellSpan = a_flags.x;
  v_skip = cellSpan == 0u ? 1.0 : 0.0;
  float span = max(float(cellSpan), 1.0);

  int cols = int(u_gridSize.x);
  int row = gl_InstanceID / cols;
  int col = gl_InstanceID - row * cols;
  vec2 cellOrigin = vec2(float(col), float(row)) * u_cellSize;
  vec2 size = vec2(u_cellSize.x * span, u_cellSize.y);
  vec2 pos = cellOrigin + a_position * size;

  vec2 canvasSize = u_gridSize * u_cellSize;
  vec2 ndc = (pos / canvasSize) * 2.0 - 1.0;
  ndc.y = -ndc.y;
  gl_Position = vec4(ndc, 0.0, 1.0);

  v_bgColor = vec4(a_bgColor) / 255.0;
}
`;

export const backgroundFragmentSource = `#version 300 es
precision highp float;

in vec4 v_bgColor;
flat in float v_skip;

out vec4 fragColor;

void main() {
  if (v_skip > 0.5 || v_bgColor.a <= 0.0) {
    discard;
  }
  float a = v_bgColor.a;
  fragColor = vec4(v_bgColor.rgb * a, a);
}
`;

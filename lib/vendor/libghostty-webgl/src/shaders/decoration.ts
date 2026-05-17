export const decorationVertexSource = `#version 300 es
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
uniform float u_baseline;

out vec2 v_posPx;
out vec4 v_decoColor;
flat out float v_skip;
flat out uint v_decoFlags;

void main() {
  uint cellSpan = a_flags.x;
  v_skip = cellSpan == 0u ? 1.0 : 0.0;
  v_decoFlags = a_flags.y;

  int cols = int(u_gridSize.x);
  int row = gl_InstanceID / cols;
  int col = gl_InstanceID - row * cols;

  vec2 cellOrigin = vec2(float(col), float(row)) * u_cellSize;
  float span = max(float(cellSpan), 1.0);
  vec2 size = vec2(u_cellSize.x * span, u_cellSize.y);
  vec2 pos = cellOrigin + a_position * size;

  vec2 canvasSize = u_gridSize * u_cellSize;
  vec2 ndc = (pos / canvasSize) * 2.0 - 1.0;
  ndc.y = -ndc.y;
  gl_Position = vec4(ndc, 0.0, 1.0);

  v_posPx = a_position * size;
  v_decoColor = vec4(a_decoColor) / 255.0;
}
`;

export const decorationFragmentSource = `#version 300 es
precision highp float;
precision highp int;

in vec2 v_posPx;
in vec4 v_decoColor;
flat in float v_skip;
flat in uint v_decoFlags;

uniform vec2 u_cellSize;
uniform float u_baseline;

out vec4 fragColor;

const uint UNDERLINE = 1u;
const uint STRIKE = 2u;
const uint HYPERLINK = 4u;
const uint CURLY = 8u;

void main() {
  if (v_skip > 0.5 || v_decoFlags == 0u || v_decoColor.a <= 0.0) {
    discard;
  }

  float y = v_posPx.y;
  float thickness = 1.0;
  bool draw = false;

  if ((v_decoFlags & UNDERLINE) != 0u || (v_decoFlags & HYPERLINK) != 0u) {
    float underlineY = u_baseline + 2.0;
    draw = draw || (y >= underlineY && y <= underlineY + thickness);
  }

  if ((v_decoFlags & STRIKE) != 0u) {
    float strikeY = u_cellSize.y * 0.5;
    draw = draw || (y >= strikeY && y <= strikeY + thickness);
  }

  if ((v_decoFlags & CURLY) != 0u) {
    float baseY = u_baseline + 2.0;
    float wave = sin((v_posPx.x / max(1.0, u_cellSize.x)) * 6.2831853 * 2.0);
    float waveY = baseY + wave;
    draw = draw || abs(y - waveY) <= thickness;
  }

  if (!draw) {
    discard;
  }

  float a = v_decoColor.a;
  fragColor = vec4(v_decoColor.rgb * a, a);
}
`;

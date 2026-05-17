export const glyphVertexSource = `#version 300 es
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
uniform vec2 u_atlasSize;
uniform float u_baseline;

out vec2 v_texCoord;
out vec4 v_fgColor;
flat out float v_skip;
flat out float v_colorAtlas;

void main() {
  uint cellSpan = a_flags.x;
  v_skip = (cellSpan == 0u || a_atlasRect.z == 0u || a_atlasRect.w == 0u) ? 1.0 : 0.0;

  int cols = int(u_gridSize.x);
  int row = gl_InstanceID / cols;
  int col = gl_InstanceID - row * cols;
  vec2 cellOrigin = vec2(float(col), float(row)) * u_cellSize;

  vec2 atlasPos = vec2(a_atlasRect.xy);
  vec2 atlasSize = vec2(a_atlasRect.zw);
  vec2 bearing = vec2(a_bearing);
  vec2 baselineOrigin = cellOrigin + vec2(0.0, u_baseline);
  vec2 glyphPos = baselineOrigin + vec2(bearing.x, -bearing.y) + a_position * atlasSize;

  vec2 canvasSize = u_gridSize * u_cellSize;
  vec2 ndc = (glyphPos / canvasSize) * 2.0 - 1.0;
  ndc.y = -ndc.y;
  gl_Position = vec4(ndc, 0.0, 1.0);

  v_texCoord = (atlasPos + a_position * atlasSize) / u_atlasSize;
  v_fgColor = vec4(a_fgColor) / 255.0;
  v_colorAtlas = float(a_flags.z & 1u);
}
`;

export const glyphFragmentSource = `#version 300 es
precision highp float;

uniform sampler2D u_atlas;
uniform sampler2D u_colorAtlas;

in vec2 v_texCoord;
in vec4 v_fgColor;
flat in float v_skip;
flat in float v_colorAtlas;

out vec4 fragColor;

void main() {
  if (v_skip > 0.5) {
    discard;
  }

  if (v_colorAtlas > 0.5) {
    vec4 rgba = texture(u_colorAtlas, v_texCoord);
    float outA = rgba.a * v_fgColor.a;
    fragColor = vec4(rgba.rgb * v_fgColor.a, outA);
  } else {
    float coverage = texture(u_atlas, v_texCoord).r;
    float outA = v_fgColor.a * coverage;
    fragColor = vec4(v_fgColor.rgb * outA, outA);
  }
}
`;

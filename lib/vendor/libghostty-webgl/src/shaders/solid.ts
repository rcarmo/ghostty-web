export const solidVertexSource = `#version 300 es
precision highp float;

layout(location = 0) in vec2 a_position;

uniform vec2 u_rectOrigin;
uniform vec2 u_rectSize;
uniform vec2 u_canvasSize;

void main() {
  vec2 pos = u_rectOrigin + a_position * u_rectSize;
  vec2 ndc = (pos / u_canvasSize) * 2.0 - 1.0;
  ndc.y = -ndc.y;
  gl_Position = vec4(ndc, 0.0, 1.0);
}
`;

export const solidFragmentSource = `#version 300 es
precision highp float;

uniform vec4 u_color;

out vec4 fragColor;

void main() {
  if (u_color.a <= 0.0) {
    discard;
  }
  fragColor = u_color;
}
`;

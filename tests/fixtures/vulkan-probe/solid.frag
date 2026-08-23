#version 450

// Solid-colour fragment stage. The probe checks the centre pixel against this
// exact value, so keep it distinct from the render pass clear colour (black).

layout(location = 0) out vec4 outColor;

void main() {
  outColor = vec4(0.0, 1.0, 0.0, 1.0);
}

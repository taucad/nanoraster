#version 450

// Pass-through vertex stage: one vec2 position per vertex, binding 0, stride 8.
// Mirrors what wgpu-hal's Vulkan backend builds for a single non-instanced
// vertex buffer (VkVertexInputBindingDescription stride 8, one R32G32_SFLOAT
// attribute at offset 0).

layout(location = 0) in vec2 inPosition;

void main() {
  gl_Position = vec4(inPosition, 0.0, 1.0);
}

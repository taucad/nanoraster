/*
 * Standalone Vulkan probe for the 32-bit ARM lavapipe render fault.
 *
 * Draws one triangle into a 64x64 offscreen R8G8B8A8_UNORM image and reads the
 * centre pixel back. It depends on the Vulkan headers and the loader only: no
 * SDK helpers, no nanoraster, no wgpu, no Rust. Its purpose is to decide
 * whether the SIGSEGV that kills nanoraster on 32-bit ARM hosts running mesa's
 * software Vulkan driver comes from mesa or from nanoraster's own stack.
 *
 * The command sequence mirrors what the vendored wgpu-hal Vulkan backend
 * issues for a single non-instanced vertex buffer: plain vkCmdBindVertexBuffers
 * (never vkCmdBindVertexBuffers2), dynamic viewport and scissor, a render pass
 * object (not dynamic rendering), triangle-list topology, no depth attachment,
 * no culling.
 *
 * Exit codes:
 *   0  the centre pixel holds the fragment colour
 *   1  a Vulkan call failed (the step and the VkResult are printed)
 *   2  the centre pixel holds something else
 *
 * Build:  gcc -O1 -g -std=c11 -Wall -Wextra -Werror probe.c -lvulkan -o probe
 * See README.md for the per-image package lines.
 */

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <vulkan/vulkan.h>

#include "shaders.h"

#define WIDTH 64u
#define HEIGHT 64u

/* The value solid.frag writes, as R8G8B8A8_UNORM bytes. */
static const uint8_t kExpectedPixel[4] = {0x00, 0xff, 0x00, 0xff};

/* Full-viewport triangle, one vec2 per vertex, 8-byte stride. */
static const float kVertices[6] = {-1.0f, -1.0f, 3.0f, -1.0f, -1.0f, 3.0f};

static void step(const char *message) {
  printf("step: %s\n", message);
  fflush(stdout);
}

static void fail(const char *what, VkResult result) {
  printf("fail: %s (VkResult %d)\n", what, (int)result);
  fflush(stdout);
  exit(1);
}

#define CHECK(expr, what)                       \
  do {                                          \
    VkResult check_result = (expr);             \
    if (check_result != VK_SUCCESS) {           \
      fail((what), check_result);               \
    }                                           \
  } while (0)

static uint32_t find_memory_type(VkPhysicalDevice gpu, uint32_t type_bits,
                                 VkMemoryPropertyFlags wanted) {
  VkPhysicalDeviceMemoryProperties memory;
  vkGetPhysicalDeviceMemoryProperties(gpu, &memory);
  for (uint32_t i = 0; i < memory.memoryTypeCount; i++) {
    if ((type_bits & (1u << i)) != 0 &&
        (memory.memoryTypes[i].propertyFlags & wanted) == wanted) {
      return i;
    }
  }
  fail("no memory type matches the request", VK_ERROR_FEATURE_NOT_PRESENT);
  return 0;
}

static VkDeviceMemory allocate_bound_buffer(VkDevice device, VkPhysicalDevice gpu,
                                            VkBuffer buffer,
                                            VkMemoryPropertyFlags wanted) {
  VkMemoryRequirements requirements;
  vkGetBufferMemoryRequirements(device, buffer, &requirements);
  VkMemoryAllocateInfo allocate = {
      .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO,
      .allocationSize = requirements.size,
      .memoryTypeIndex =
          find_memory_type(gpu, requirements.memoryTypeBits, wanted),
  };
  VkDeviceMemory memory = VK_NULL_HANDLE;
  CHECK(vkAllocateMemory(device, &allocate, NULL, &memory),
        "vkAllocateMemory for a buffer");
  CHECK(vkBindBufferMemory(device, buffer, memory, 0), "vkBindBufferMemory");
  return memory;
}

static VkBuffer create_buffer(VkDevice device, VkDeviceSize size,
                              VkBufferUsageFlags usage) {
  VkBufferCreateInfo info = {
      .sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO,
      .size = size,
      .usage = usage,
      .sharingMode = VK_SHARING_MODE_EXCLUSIVE,
  };
  VkBuffer buffer = VK_NULL_HANDLE;
  CHECK(vkCreateBuffer(device, &info, NULL, &buffer), "vkCreateBuffer");
  return buffer;
}

static VkShaderModule create_shader(VkDevice device, const uint32_t *code,
                                    size_t bytes) {
  VkShaderModuleCreateInfo info = {
      .sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO,
      .codeSize = bytes,
      .pCode = code,
  };
  VkShaderModule module = VK_NULL_HANDLE;
  CHECK(vkCreateShaderModule(device, &info, NULL, &module),
        "vkCreateShaderModule");
  return module;
}

/* Prints deviceName, the version numbers, and — when the implementation offers
 * VK_KHR_driver_properties — driverName and driverInfo verbatim. driverInfo is
 * the string wgpu surfaces as AdapterInfo.driver_info, so its exact shape is
 * what a host-condition guard has to parse. */
static void print_adapter(VkInstance instance, VkPhysicalDevice gpu) {
  VkPhysicalDeviceProperties properties;
  vkGetPhysicalDeviceProperties(gpu, &properties);
  printf("deviceName: %s\n", properties.deviceName);
  printf("driverVersion: %u.%u.%u\n", VK_VERSION_MAJOR(properties.driverVersion),
         VK_VERSION_MINOR(properties.driverVersion),
         VK_VERSION_PATCH(properties.driverVersion));
  printf("apiVersion: %u.%u.%u\n", VK_VERSION_MAJOR(properties.apiVersion),
         VK_VERSION_MINOR(properties.apiVersion),
         VK_VERSION_PATCH(properties.apiVersion));

  PFN_vkGetPhysicalDeviceProperties2 get2 =
      (PFN_vkGetPhysicalDeviceProperties2)vkGetInstanceProcAddr(
          instance, "vkGetPhysicalDeviceProperties2");
  if (get2 == NULL) {
    get2 = (PFN_vkGetPhysicalDeviceProperties2)vkGetInstanceProcAddr(
        instance, "vkGetPhysicalDeviceProperties2KHR");
  }
  if (get2 == NULL) {
    printf("driverName: <vkGetPhysicalDeviceProperties2 unavailable>\n");
    printf("driverInfo: <vkGetPhysicalDeviceProperties2 unavailable>\n");
    return;
  }
  VkPhysicalDeviceDriverProperties driver = {
      .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_DRIVER_PROPERTIES,
  };
  VkPhysicalDeviceProperties2 chained = {
      .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2,
      .pNext = &driver,
  };
  get2(gpu, &chained);
  printf("driverName: %s\n", driver.driverName);
  printf("driverInfo: %s\n", driver.driverInfo);
}

int main(void) {
  step("vkCreateInstance");
  VkApplicationInfo application = {
      .sType = VK_STRUCTURE_TYPE_APPLICATION_INFO,
      .pApplicationName = "nanoraster-vulkan-probe",
      .applicationVersion = 1,
      .pEngineName = "nanoraster-vulkan-probe",
      .engineVersion = 1,
      .apiVersion = VK_API_VERSION_1_1,
  };
  VkInstanceCreateInfo instance_info = {
      .sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO,
      .pApplicationInfo = &application,
  };
  VkInstance instance = VK_NULL_HANDLE;
  VkResult instance_result = vkCreateInstance(&instance_info, NULL, &instance);
  if (instance_result == VK_ERROR_INCOMPATIBLE_DRIVER) {
    application.apiVersion = VK_API_VERSION_1_0;
    instance_result = vkCreateInstance(&instance_info, NULL, &instance);
  }
  CHECK(instance_result, "vkCreateInstance");

  step("vkEnumeratePhysicalDevices");
  uint32_t gpu_count = 0;
  CHECK(vkEnumeratePhysicalDevices(instance, &gpu_count, NULL),
        "vkEnumeratePhysicalDevices (count)");
  if (gpu_count == 0) {
    fail("no physical device", VK_ERROR_INITIALIZATION_FAILED);
  }
  VkPhysicalDevice gpus[8];
  if (gpu_count > 8) {
    gpu_count = 8;
  }
  CHECK(vkEnumeratePhysicalDevices(instance, &gpu_count, gpus),
        "vkEnumeratePhysicalDevices (list)");
  VkPhysicalDevice gpu = gpus[0];
  print_adapter(instance, gpu);

  step("vkCreateDevice");
  uint32_t family_count = 0;
  vkGetPhysicalDeviceQueueFamilyProperties(gpu, &family_count, NULL);
  VkQueueFamilyProperties families[16];
  if (family_count > 16) {
    family_count = 16;
  }
  vkGetPhysicalDeviceQueueFamilyProperties(gpu, &family_count, families);
  uint32_t family = UINT32_MAX;
  for (uint32_t i = 0; i < family_count; i++) {
    if ((families[i].queueFlags & VK_QUEUE_GRAPHICS_BIT) != 0) {
      family = i;
      break;
    }
  }
  if (family == UINT32_MAX) {
    fail("no graphics queue family", VK_ERROR_INITIALIZATION_FAILED);
  }
  float priority = 1.0f;
  VkDeviceQueueCreateInfo queue_info = {
      .sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO,
      .queueFamilyIndex = family,
      .queueCount = 1,
      .pQueuePriorities = &priority,
  };
  VkDeviceCreateInfo device_info = {
      .sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO,
      .queueCreateInfoCount = 1,
      .pQueueCreateInfos = &queue_info,
  };
  VkDevice device = VK_NULL_HANDLE;
  CHECK(vkCreateDevice(gpu, &device_info, NULL, &device), "vkCreateDevice");
  VkQueue queue = VK_NULL_HANDLE;
  vkGetDeviceQueue(device, family, 0, &queue);

  step("upload the vertex buffer");
  VkBuffer vertex_buffer =
      create_buffer(device, sizeof kVertices, VK_BUFFER_USAGE_VERTEX_BUFFER_BIT);
  VkDeviceMemory vertex_memory = allocate_bound_buffer(
      device, gpu, vertex_buffer,
      VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);
  void *mapped = NULL;
  CHECK(vkMapMemory(device, vertex_memory, 0, sizeof kVertices, 0, &mapped),
        "vkMapMemory for the vertex buffer");
  memcpy(mapped, kVertices, sizeof kVertices);
  vkUnmapMemory(device, vertex_memory);

  step("create the offscreen image");
  VkImageCreateInfo image_info = {
      .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO,
      .imageType = VK_IMAGE_TYPE_2D,
      .format = VK_FORMAT_R8G8B8A8_UNORM,
      .extent = {WIDTH, HEIGHT, 1},
      .mipLevels = 1,
      .arrayLayers = 1,
      .samples = VK_SAMPLE_COUNT_1_BIT,
      .tiling = VK_IMAGE_TILING_OPTIMAL,
      .usage = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT,
      .sharingMode = VK_SHARING_MODE_EXCLUSIVE,
      .initialLayout = VK_IMAGE_LAYOUT_UNDEFINED,
  };
  VkImage image = VK_NULL_HANDLE;
  CHECK(vkCreateImage(device, &image_info, NULL, &image), "vkCreateImage");
  VkMemoryRequirements image_requirements;
  vkGetImageMemoryRequirements(device, image, &image_requirements);
  VkMemoryAllocateInfo image_allocate = {
      .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO,
      .allocationSize = image_requirements.size,
      .memoryTypeIndex = find_memory_type(gpu, image_requirements.memoryTypeBits,
                                          VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT),
  };
  VkDeviceMemory image_memory = VK_NULL_HANDLE;
  CHECK(vkAllocateMemory(device, &image_allocate, NULL, &image_memory),
        "vkAllocateMemory for the image");
  CHECK(vkBindImageMemory(device, image, image_memory, 0), "vkBindImageMemory");
  VkImageViewCreateInfo view_info = {
      .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO,
      .image = image,
      .viewType = VK_IMAGE_VIEW_TYPE_2D,
      .format = VK_FORMAT_R8G8B8A8_UNORM,
      .subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1},
  };
  VkImageView view = VK_NULL_HANDLE;
  CHECK(vkCreateImageView(device, &view_info, NULL, &view), "vkCreateImageView");

  step("create the render pass and framebuffer");
  VkAttachmentDescription attachment = {
      .format = VK_FORMAT_R8G8B8A8_UNORM,
      .samples = VK_SAMPLE_COUNT_1_BIT,
      .loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR,
      .storeOp = VK_ATTACHMENT_STORE_OP_STORE,
      .stencilLoadOp = VK_ATTACHMENT_LOAD_OP_DONT_CARE,
      .stencilStoreOp = VK_ATTACHMENT_STORE_OP_DONT_CARE,
      .initialLayout = VK_IMAGE_LAYOUT_UNDEFINED,
      .finalLayout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,
  };
  VkAttachmentReference color_reference = {
      .attachment = 0,
      .layout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL,
  };
  VkSubpassDescription subpass = {
      .pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS,
      .colorAttachmentCount = 1,
      .pColorAttachments = &color_reference,
  };
  VkSubpassDependency dependency = {
      .srcSubpass = 0,
      .dstSubpass = VK_SUBPASS_EXTERNAL,
      .srcStageMask = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT,
      .dstStageMask = VK_PIPELINE_STAGE_TRANSFER_BIT,
      .srcAccessMask = VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT,
      .dstAccessMask = VK_ACCESS_TRANSFER_READ_BIT,
  };
  VkRenderPassCreateInfo render_pass_info = {
      .sType = VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO,
      .attachmentCount = 1,
      .pAttachments = &attachment,
      .subpassCount = 1,
      .pSubpasses = &subpass,
      .dependencyCount = 1,
      .pDependencies = &dependency,
  };
  VkRenderPass render_pass = VK_NULL_HANDLE;
  CHECK(vkCreateRenderPass(device, &render_pass_info, NULL, &render_pass),
        "vkCreateRenderPass");
  VkFramebufferCreateInfo framebuffer_info = {
      .sType = VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO,
      .renderPass = render_pass,
      .attachmentCount = 1,
      .pAttachments = &view,
      .width = WIDTH,
      .height = HEIGHT,
      .layers = 1,
  };
  VkFramebuffer framebuffer = VK_NULL_HANDLE;
  CHECK(vkCreateFramebuffer(device, &framebuffer_info, NULL, &framebuffer),
        "vkCreateFramebuffer");

  step("create the graphics pipeline");
  VkShaderModule vertex_module =
      create_shader(device, kTriangleVertSpv, sizeof kTriangleVertSpv);
  VkShaderModule fragment_module =
      create_shader(device, kSolidFragSpv, sizeof kSolidFragSpv);
  VkPipelineShaderStageCreateInfo stages[2] = {
      {
          .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO,
          .stage = VK_SHADER_STAGE_VERTEX_BIT,
          .module = vertex_module,
          .pName = "main",
      },
      {
          .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO,
          .stage = VK_SHADER_STAGE_FRAGMENT_BIT,
          .module = fragment_module,
          .pName = "main",
      },
  };
  VkVertexInputBindingDescription binding = {
      .binding = 0,
      .stride = 2 * sizeof(float),
      .inputRate = VK_VERTEX_INPUT_RATE_VERTEX,
  };
  VkVertexInputAttributeDescription attribute = {
      .location = 0,
      .binding = 0,
      .format = VK_FORMAT_R32G32_SFLOAT,
      .offset = 0,
  };
  VkPipelineVertexInputStateCreateInfo vertex_input = {
      .sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO,
      .vertexBindingDescriptionCount = 1,
      .pVertexBindingDescriptions = &binding,
      .vertexAttributeDescriptionCount = 1,
      .pVertexAttributeDescriptions = &attribute,
  };
  VkPipelineInputAssemblyStateCreateInfo input_assembly = {
      .sType = VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO,
      .topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST,
      .primitiveRestartEnable = VK_FALSE,
  };
  VkPipelineViewportStateCreateInfo viewport_state = {
      .sType = VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO,
      .viewportCount = 1,
      .scissorCount = 1,
  };
  VkPipelineRasterizationStateCreateInfo rasterization = {
      .sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO,
      .polygonMode = VK_POLYGON_MODE_FILL,
      .cullMode = VK_CULL_MODE_NONE,
      .frontFace = VK_FRONT_FACE_COUNTER_CLOCKWISE,
      .lineWidth = 1.0f,
  };
  VkPipelineMultisampleStateCreateInfo multisample = {
      .sType = VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO,
      .rasterizationSamples = VK_SAMPLE_COUNT_1_BIT,
  };
  VkPipelineColorBlendAttachmentState blend_attachment = {
      .blendEnable = VK_FALSE,
      .colorWriteMask = VK_COLOR_COMPONENT_R_BIT | VK_COLOR_COMPONENT_G_BIT |
                        VK_COLOR_COMPONENT_B_BIT | VK_COLOR_COMPONENT_A_BIT,
  };
  VkPipelineColorBlendStateCreateInfo blend = {
      .sType = VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO,
      .attachmentCount = 1,
      .pAttachments = &blend_attachment,
  };
  /* wgpu-hal declares exactly these four dynamic states for every render
   * pipeline; see rust/vendor/wgpu-hal/src/vulkan/device.rs. */
  VkDynamicState dynamic_states[4] = {
      VK_DYNAMIC_STATE_VIEWPORT,
      VK_DYNAMIC_STATE_SCISSOR,
      VK_DYNAMIC_STATE_BLEND_CONSTANTS,
      VK_DYNAMIC_STATE_STENCIL_REFERENCE,
  };
  VkPipelineDynamicStateCreateInfo dynamic = {
      .sType = VK_STRUCTURE_TYPE_PIPELINE_DYNAMIC_STATE_CREATE_INFO,
      .dynamicStateCount = 4,
      .pDynamicStates = dynamic_states,
  };
  VkPipelineLayoutCreateInfo layout_info = {
      .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
  };
  VkPipelineLayout layout = VK_NULL_HANDLE;
  CHECK(vkCreatePipelineLayout(device, &layout_info, NULL, &layout),
        "vkCreatePipelineLayout");
  VkGraphicsPipelineCreateInfo pipeline_info = {
      .sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO,
      .stageCount = 2,
      .pStages = stages,
      .pVertexInputState = &vertex_input,
      .pInputAssemblyState = &input_assembly,
      .pViewportState = &viewport_state,
      .pRasterizationState = &rasterization,
      .pMultisampleState = &multisample,
      .pColorBlendState = &blend,
      .pDynamicState = &dynamic,
      .layout = layout,
      .renderPass = render_pass,
      .subpass = 0,
  };
  VkPipeline pipeline = VK_NULL_HANDLE;
  CHECK(vkCreateGraphicsPipelines(device, VK_NULL_HANDLE, 1, &pipeline_info, NULL,
                                  &pipeline),
        "vkCreateGraphicsPipelines");

  step("create the readback buffer and command pool");
  VkBuffer readback = create_buffer(device, (VkDeviceSize)WIDTH * HEIGHT * 4,
                                    VK_BUFFER_USAGE_TRANSFER_DST_BIT);
  VkDeviceMemory readback_memory = allocate_bound_buffer(
      device, gpu, readback,
      VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);
  VkCommandPoolCreateInfo pool_info = {
      .sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO,
      .queueFamilyIndex = family,
  };
  VkCommandPool pool = VK_NULL_HANDLE;
  CHECK(vkCreateCommandPool(device, &pool_info, NULL, &pool),
        "vkCreateCommandPool");
  VkCommandBufferAllocateInfo command_allocate = {
      .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO,
      .commandPool = pool,
      .level = VK_COMMAND_BUFFER_LEVEL_PRIMARY,
      .commandBufferCount = 1,
  };
  VkCommandBuffer commands = VK_NULL_HANDLE;
  CHECK(vkAllocateCommandBuffers(device, &command_allocate, &commands),
        "vkAllocateCommandBuffers");
  VkCommandBufferBeginInfo begin = {
      .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO,
      .flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT,
  };
  step("vkBeginCommandBuffer");
  CHECK(vkBeginCommandBuffer(commands, &begin), "vkBeginCommandBuffer");
  VkClearValue clear = {.color = {.float32 = {0.0f, 0.0f, 0.0f, 1.0f}}};
  VkRenderPassBeginInfo pass_begin = {
      .sType = VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO,
      .renderPass = render_pass,
      .framebuffer = framebuffer,
      .renderArea = {{0, 0}, {WIDTH, HEIGHT}},
      .clearValueCount = 1,
      .pClearValues = &clear,
  };
  step("vkCmdBeginRenderPass");
  vkCmdBeginRenderPass(commands, &pass_begin, VK_SUBPASS_CONTENTS_INLINE);
  step("vkCmdBindPipeline");
  vkCmdBindPipeline(commands, VK_PIPELINE_BIND_POINT_GRAPHICS, pipeline);
  VkViewport viewport = {0.0f, (float)HEIGHT, (float)WIDTH, -(float)HEIGHT,
                         0.0f, 1.0f};
  step("vkCmdSetViewport");
  vkCmdSetViewport(commands, 0, 1, &viewport);
  VkRect2D scissor = {{0, 0}, {WIDTH, HEIGHT}};
  step("vkCmdSetScissor");
  vkCmdSetScissor(commands, 0, 1, &scissor);
  /* The call under suspicion: the non-"2" entry point, exactly as wgpu-hal's
   * set_vertex_buffer issues it. No strides travel from here. */
  VkDeviceSize vertex_offset = 0;
  step("vkCmdBindVertexBuffers");
  vkCmdBindVertexBuffers(commands, 0, 1, &vertex_buffer, &vertex_offset);
  step("vkCmdDraw");
  vkCmdDraw(commands, 3, 1, 0, 0);
  step("vkCmdEndRenderPass");
  vkCmdEndRenderPass(commands);
  VkBufferImageCopy copy = {
      .imageSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1},
      .imageExtent = {WIDTH, HEIGHT, 1},
  };
  step("vkCmdCopyImageToBuffer");
  vkCmdCopyImageToBuffer(commands, image, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,
                         readback, 1, &copy);
  VkMemoryBarrier host_barrier = {
      .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER,
      .srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT,
      .dstAccessMask = VK_ACCESS_HOST_READ_BIT,
  };
  step("vkCmdPipelineBarrier");
  vkCmdPipelineBarrier(commands, VK_PIPELINE_STAGE_TRANSFER_BIT,
                       VK_PIPELINE_STAGE_HOST_BIT, 0, 1, &host_barrier, 0, NULL,
                       0, NULL);
  step("vkEndCommandBuffer");
  CHECK(vkEndCommandBuffer(commands), "vkEndCommandBuffer");

  step("vkQueueSubmit");
  VkSubmitInfo submit = {
      .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO,
      .commandBufferCount = 1,
      .pCommandBuffers = &commands,
  };
  CHECK(vkQueueSubmit(queue, 1, &submit, VK_NULL_HANDLE), "vkQueueSubmit");

  step("vkQueueWaitIdle");
  CHECK(vkQueueWaitIdle(queue), "vkQueueWaitIdle");

  step("read back the centre pixel");
  void *pixels = NULL;
  CHECK(vkMapMemory(device, readback_memory, 0, VK_WHOLE_SIZE, 0, &pixels),
        "vkMapMemory for the readback buffer");
  const uint8_t *centre =
      (const uint8_t *)pixels + ((HEIGHT / 2) * WIDTH + (WIDTH / 2)) * 4;
  printf("centre pixel: %02x%02x%02x%02x\n", centre[0], centre[1], centre[2],
         centre[3]);
  int matches = memcmp(centre, kExpectedPixel, 4) == 0;
  printf("expected pixel: %02x%02x%02x%02x\n", kExpectedPixel[0],
         kExpectedPixel[1], kExpectedPixel[2], kExpectedPixel[3]);
  vkUnmapMemory(device, readback_memory);

  step("teardown");
  vkDestroyCommandPool(device, pool, NULL);
  vkDestroyPipeline(device, pipeline, NULL);
  vkDestroyPipelineLayout(device, layout, NULL);
  vkDestroyShaderModule(device, fragment_module, NULL);
  vkDestroyShaderModule(device, vertex_module, NULL);
  vkDestroyFramebuffer(device, framebuffer, NULL);
  vkDestroyRenderPass(device, render_pass, NULL);
  vkDestroyImageView(device, view, NULL);
  vkDestroyImage(device, image, NULL);
  vkFreeMemory(device, image_memory, NULL);
  vkDestroyBuffer(device, readback, NULL);
  vkFreeMemory(device, readback_memory, NULL);
  vkDestroyBuffer(device, vertex_buffer, NULL);
  vkFreeMemory(device, vertex_memory, NULL);
  vkDestroyDevice(device, NULL);
  vkDestroyInstance(instance, NULL);

  printf("result: %s\n", matches ? "rendered" : "wrong pixel");
  fflush(stdout);
  return matches ? 0 : 2;
}

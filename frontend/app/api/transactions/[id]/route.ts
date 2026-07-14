// See docs/SPECIFICATION.md section 4.2.

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // TODO: edit amount/category/type
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // TODO: soft delete (set deleted_at) - never hard delete
}

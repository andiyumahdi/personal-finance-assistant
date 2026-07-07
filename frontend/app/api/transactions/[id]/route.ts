// See docs/SPECIFICATION.md section 4.2.

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  // TODO: edit amount/category/type
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  // TODO: soft delete (set deleted_at) - never hard delete
}

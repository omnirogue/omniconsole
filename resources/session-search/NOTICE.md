# Session search embedding model

`static-embedding.bin` is derived from
[minishlab/potion-base-2M](https://huggingface.co/minishlab/potion-base-2M) (Model2Vec static
embeddings distilled from BAAI/bge-base-en-v1.5), released under the MIT License.
The 29,528 × 64 float32 matrix was quantized to int8 with one float32 scale per row. File
layout: `SSE2` magic, u32 vocab size, u32 dimensions, u32 vocab bytes, the model's WordPiece
vocabulary (UTF-8, newline-separated, id order), float32 scales, int8 rows.

MIT License — Copyright (c) 2024 Minish Lab

Permission is hereby granted, free of charge, to any person obtaining a copy of this software
and associated documentation files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

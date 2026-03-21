const mongoose = require("mongoose");

const NotebookSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  description: {
    type: String,
    required: true,
  },
  price: {
    type: Number,
    required: true,
    min: 0,
  },
  image: {
    type: String,
    default: "",
  },
  category: {
    type: String,
    required: true,
  },
  pages: {
    type: Number,
    required: true,
  },
  size: {
    type: String,
    required: true,
  },
  inStock: {
    type: Boolean,
    default: true,
  },
  stockQuantity: {
    type: Number,
    default: 0,
  },
  weight: {
    type: Number,
    default: 0,
    min: 0,
  },
  lengthCm: {
    type: Number,
    default: 25,
    min: 0.5,
  },
  breadthCm: {
    type: Number,
    default: 20,
    min: 0.5,
  },
  heightCm: {
    type: Number,
    default: 0.8,
    min: 0.5,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("Notebook", NotebookSchema);

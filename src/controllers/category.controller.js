import Job from "../models/job.model.js";

export const getCategories = async (req, res) => {
  try {
    const categories = await Job.aggregate([
      {
        $group: {
          _id: "$category",
          count: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          title: "$_id",
          jobs: "$count",
        },
      },
      {
        $sort: {
          jobs: -1,
        },
      },
    ]);

    res.status(200).json(categories);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      message: "Failed to fetch categories",
    });
  }
};
